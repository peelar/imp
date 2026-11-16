// The backup's GitHub side: the person's private imp-apps repository, found or made through GitHub's API with the
// GitHub connection (connections/), which the host hands the backup as `GithubApi`.
import { compile, obj, str } from "@earendil-works/pi-schema";

/** The repository the apps go to, under the person's GitHub account. */
const REPO_NAME = "imp-apps";

/** Where the versions are pushed: "owner/imp-apps" and its address. */
export type Remote = { readonly repo: string; readonly url: string };

/** A request to GitHub's REST API, such as GET /user, sent with the owner's github key; answers its status and body. */
export type GithubApi = (request: {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: Record<string, string | boolean>;
}) => Promise<{ readonly status: number; readonly body: string }>;

const userJson = compile(obj({ login: str() }, { open: true }));
const repoJson = compile(obj({ clone_url: str() }, { open: true }));

/** What GitHub answered, checked; throws what went wrong. */
function answered<T>(
  what: string,
  answer: { status: number; body: string },
  expected: { check: (value: unknown) => value is T }
): T {
  let value: unknown;

  try {
    value = JSON.parse(answer.body);
  } catch {
    value = undefined;
  }

  if (answer.status < 200 || answer.status > 299 || !expected.check(value)) {
    throw new Error(`GitHub answered ${answer.status} for ${what}.`);
  }

  return value;
}

/** The person's imp-apps repository, made private if it is not there yet. */
export async function personalRepository(api: GithubApi): Promise<Remote> {
  const { login } = answered(
    "your account",
    await api({ method: "GET", path: "/user" }),
    userJson
  );

  const repo = `${login}/${REPO_NAME}`;
  const found = await api({ method: "GET", path: `/repos/${repo}` });

  const made =
    found.status === 404
      ? await api({
          method: "POST",
          path: "/user/repos",
          body: {
            name: REPO_NAME,
            private: true,
            description: "My Imp apps' code, backed up by my Imp host.",
          },
        })
      : found;

  return { repo, url: answered(repo, made, repoJson).clone_url };
}
