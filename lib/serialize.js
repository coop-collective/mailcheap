// Convert stored dates to JSON values before passing records into client components.
export function serialize(value) {
	return JSON.parse(JSON.stringify(value));
}
