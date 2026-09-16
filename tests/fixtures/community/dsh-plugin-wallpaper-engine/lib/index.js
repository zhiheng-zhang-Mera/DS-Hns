// dsh-plugin-wallpaper-engine host half (test fixture).
//
// Read, never run, by everything in this repository: the structure reader parses the file for an
// exported `inject` declaration, and nothing imports it. The declaration is written the way a
// bundler emits one — a binding re-exported from the list at the bottom — because that is the
// spelling the reader has to handle.
const inject = ['webServer']

export { inject }
export const name = 'dsh-plugin-wallpaper-engine'
