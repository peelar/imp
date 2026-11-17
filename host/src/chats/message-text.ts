// The words of a model message. Its content is text, or parts of which only the text ones are words.

export type MessageContent =
  | string
  | readonly { readonly type: string; readonly text?: string }[];

const isText = (content: MessageContent): content is string =>
  typeof content === "string";

/** The message's parts, such as the images the person sent with it; none when its content is text alone. */
export const messageParts = (content: MessageContent) =>
  isText(content) ? [] : content;

/** The message's text; "" when it has none. */
export function messageText(content: MessageContent | undefined): string {
  if (content === undefined || isText(content)) {
    return content ?? "";
  }

  return content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("")
    .trim();
}
