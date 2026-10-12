// Resolve bindings only inside a Worker invocation. Dynamic import also lets pure
// utility tests run in Node without a Cloudflare runtime or production credentials.
export async function getCloudflareEnv() {
	const { env } = await import("cloudflare:workers");
	return env;
}
