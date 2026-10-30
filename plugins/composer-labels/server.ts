// bb-plugin-composer-labels — backend entry. The plugin is purely a frontend
// stylesheet, but `bb plugin build` and the manifest require a server entry, so
// this file exists and registers nothing.
export default async function plugin(): Promise<void> {}
