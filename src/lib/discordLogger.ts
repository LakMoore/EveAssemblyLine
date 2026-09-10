const discordMessageLimit = 2_000;

type DiscordErrorContext = Record<string, boolean | number | string | undefined>;

function formatErrorMessage(message: string, context: DiscordErrorContext): string {
  const details = Object
    .entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
  const content = details ? `${message}\n${details}` : message;
  return content.slice(0, discordMessageLimit);
}

async function sendErrorMessage(message: string, context: DiscordErrorContext): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const response = await fetch(
    webhookUrl,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: formatErrorMessage(message, context) }),
    },
  );
  if (!response.ok) {
    throw new Error(`Discord webhook returned HTTP ${response.status}.`);
  }
}

/** Sends application errors to the configured Discord webhook. */
export const discordLogger = {
  async error(message: string, context: DiscordErrorContext = {}): Promise<void> {
    try {
      await sendErrorMessage(message, context);
    }
    catch (error: unknown) {
      console.error(
        "Could not send Discord error log",
        error instanceof Error ? error.message : "unknown error",
      );
    }
  },
};
