/**
 * A map of words that should be replaced in Beam chat messages.
 */
const wordReplacements: [RegExp, string][] = [[/@everyone/g, 'everyone'], [/@here/g, 'here']];

/**
 *
 */
export function replace(source: string): string {
    return wordReplacements.reduce(
        (str, [re, replacement]) => str.replace(re, replacement),
        source,
    );
}
