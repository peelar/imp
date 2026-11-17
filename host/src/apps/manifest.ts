// The rules an app's operations follow (sdk/app.ts), checked when a version loads. The worker reports what the app's
// module exported; nothing in it is certain until `checkManifest` has read it.
import {
  arr,
  bool,
  compile,
  int,
  lit,
  map,
  num,
  obj,
  oneOf,
  type Optional,
  opt,
  type Schema,
  str,
  union,
  unknown,
  type Validator,
} from "@earendil-works/pi-schema";
import { isJsonValue } from "@earendil-works/chord/json";
import type { Json, Param } from "../../../sdk/app.ts";
import { checkConnections, checkEvery, checkWatch } from "./connections.ts";
import type {
  Manifest,
  Operation,
  ReportedManifest,
  ReportedOperation,
} from "./protocol.ts";

/** A loaded version of an app: its manifest, and each operation with the check for its arguments. */
export type Loaded = {
  readonly manifest: Manifest;
  readonly operations: ReadonlyMap<
    string,
    { readonly operation: Operation; readonly args: Validator }
  >;
};

/** Operation and parameter names: camelCase, so the shell's `todosSetDone` names the todos app's `setDone`. */
const NAME = /^[a-z][A-Za-z0-9]*$/;

const SCALARS = ["string", "number", "integer", "boolean"] as const;
const notes = { description: opt(str()), optional: opt(bool()) };

const migrations = compile(arr(str()));
const kind = compile(oneOf(["read", "write"]));
const description = compile(str({ pattern: String.raw`\S` }));
const paramsByName = compile(map(unknown()));

const typed = compile(
  obj({ type: oneOf([...SCALARS, "enum"]) }, { open: true })
);

const enumerated = compile(
  obj(
    { type: lit("enum"), values: arr(str(), { minItems: 1 }) },
    { open: true }
  )
);

const param = compile(
  union([
    obj({ type: oneOf(SCALARS), ...notes }),
    obj({ type: lit("enum"), values: arr(str(), { minItems: 1 }), ...notes }),
  ])
);

/**
 * Checks what the worker reported against sdk/app.ts, so an app that breaks a rule fails to load with every problem
 * named, and the agent that built it can fix them all at once.
 */
export function checkManifest(id: string, reported: ReportedManifest): Loaded {
  const problems: string[] = [];

  const schema = migrations.check(reported.schema)
    ? reported.schema
    : undefined;

  if (!schema) {
    problems.push("schema must be a list of SQL strings");
  }

  const operations = new Map<
    string,
    { operation: Operation; args: Validator }
  >();

  for (const entry of reported.operations) {
    const operation = checkOperation(entry, (problem) => {
      problems.push(`operation ${entry.name}: ${problem}`);
    });

    if (operation) {
      operations.set(operation.name, {
        operation,
        args: compile(obj(parameters(operation.params))),
      });
    }
  }

  const report = (problem: string) => {
    problems.push(problem);
  };

  const connections = checkConnections(reported.connections, report);
  const sync = checkEvery(reported.every, report);
  const watch = checkWatch(reported.watch, connections ?? [], report);

  if (!schema || !connections || !sync || !watch || problems.length > 0) {
    throw new Error(
      `The ${id} app's server.ts breaks the app rules: ${problems.join("; ")}.`
    );
  }

  return {
    manifest: {
      schema,
      operations: [...operations.values()].map((entry) => entry.operation),
      connections,
      ...sync,
      watch,
    },
    operations,
  };
}

/** The operation when it follows every rule; else reports each one it breaks. */
function checkOperation(
  reported: ReportedOperation,
  report: (problem: string) => void
): Operation | undefined {
  const named = NAME.test(reported.name);

  if (!named) {
    report("the name must be camelCase letters and digits");
  }

  if (!kind.check(reported.kind)) {
    report('kind must be "read" or "write"');
  }

  if (!description.check(reported.description)) {
    report("it needs a description");
  }

  const params = checkParams(reported.params, report);

  return named &&
    kind.check(reported.kind) &&
    description.check(reported.description) &&
    params
    ? {
        name: reported.name,
        kind: reported.kind,
        description: reported.description,
        params,
        agent: reported.agent,
      }
    : undefined;
}

function checkParams(
  reported: ReportedOperation["params"],
  report: (problem: string) => void
): Operation["params"] | undefined {
  if (!paramsByName.check(reported)) {
    report("params must be an object, {} for none");

    return undefined;
  }

  const params = new Map<string, Param>();
  let sound = true;

  for (const [name, value] of Object.entries(reported)) {
    if (!NAME.test(name)) {
      report(`param ${name}: the name must be camelCase letters and digits`);
      sound = false;
    }

    if (param.check(value)) {
      params.set(name, value);
    } else {
      report(`param ${name}: ${paramProblem(value)}`);
      sound = false;
    }
  }

  return sound ? Object.fromEntries(params) : undefined;
}

/** Why a value that failed the `param` check is not a param. */
function paramProblem(value: ReportedOperation["params"]) {
  if (!typed.check(value)) {
    return `type must be one of ${[...SCALARS, "enum"].join(", ")}`;
  }

  if (value.type === "enum" && !enumerated.check(value)) {
    return "an enum needs values, a list of strings";
  }

  return "description must be a text and optional true or false, and it takes nothing else";
}

/**
 * An operation's params as the JSON Schema of the object that carries them, with the required ones listed, as the imp
 * and other assistants read them.
 */
export function paramsSchema(params: Operation["params"]): Json {
  const schema = obj(parameters(params));

  // A schema the builders made is plain JSON; this says so to the types.
  return isJsonValue(schema) ? schema : {};
}

/** The arguments an operation takes, as the properties of the object that carries them. */
function parameters(params: Operation["params"]) {
  const scalars = { string: str, number: num, integer: int, boolean: bool };

  const properties = new Map<string, Schema | Optional>(
    Object.entries(params).map(([name, param]) => {
      const annotations = param.description
        ? { description: param.description }
        : {};

      const schema =
        param.type === "enum"
          ? oneOf(param.values, annotations)
          : scalars[param.type](annotations);

      return [name, param.optional ? opt(schema) : schema];
    })
  );

  return Object.fromEntries(properties);
}
