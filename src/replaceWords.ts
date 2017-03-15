/**
 * A map of words that should be replaced in Beam chat messages.
 */
const wordReplacements = new Map<RegExp, string>([
    [/@everyone/g, 'everyone'],
    [/@here/g, 'here'],
]);

/**
 *
 */
export function replace(source: string): string {
    wordReplacements.forEach((replacement, pattern) => {
        source = source.replace(pattern, replacement);
    });

    return source;
}
