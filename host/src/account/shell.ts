// The person's side of the model account, in Settings, the onboarding and the composer: sign in to ChatGPT, use an API
// key instead, cancel a sign-in, sign out, choose the model. What they see of it rides on the account stream (account.ts, `state`).
import { type Calls, ok, refused, text } from "../live/live.ts";
import type { ModelAccount } from "./account.ts";

export function accountCalls(account: ModelAccount): Calls {
  return [
    [
      "accountSignIn",
      () => {
        account.start();

        return ok;
      },
    ],
    [
      "accountUseKey",
      async (args) => {
        const error = await account.useKey({
          baseUrl: text(args, 0),
          key: text(args, 1),
          model: text(args, 2),
        });

        return error ? refused(error) : ok;
      },
    ],
    [
      "accountChooseModel",
      (args) => {
        const error = account.chooseModel(text(args, 0));

        return error ? refused(error) : ok;
      },
    ],
    [
      "accountCancel",
      () => {
        account.cancel();

        return ok;
      },
    ],
    [
      "accountSignOut",
      async () => {
        await account.signOut();

        return ok;
      },
    ],
  ];
}
