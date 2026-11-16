// GitHub's REST API as the test host's backup sees it (test-host.ts): the account "tester", and its repositories as
// bare git repositories in `dir`, which the backup pushes to by their path.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GithubApi } from "../src/backup/backup.ts";

export function fakeGithub(dir: string): GithubApi {
  const repoDir = (name: string) => path.join(dir, `${name}.git`);

  const answer = (status: number, body: Record<string, string>) => ({
    status,
    body: JSON.stringify(body),
  });

  return async ({ method, path: route, body }) => {
    await Promise.resolve();

    if (method === "GET" && route === "/user") {
      return answer(200, { login: "tester" });
    }

    const [, name = ""] = /^\/repos\/(.+)$/.exec(route) ?? [];

    if (method === "GET" && name) {
      return existsSync(repoDir(name))
        ? answer(200, { clone_url: repoDir(name) })
        : answer(404, { message: "Not Found" });
    }

    if (method === "POST" && route === "/user/repos") {
      const repo = repoDir(`tester/${String(body?.name)}`);

      execFileSync("git", [
        "init",
        "--quiet",
        "--bare",
        "--initial-branch=main",
        repo,
      ]);

      return answer(201, { clone_url: repo });
    }

    return answer(404, { message: "Not Found" });
  };
}
