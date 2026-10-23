// CLI certification compares disposable project paths, not the spelling of
// those paths. macOS /tmp is a symlink to /private/tmp, and native tooling may
// report real paths even when the legacy CLI reports their lexical aliases.
export function normalizeCertificationPathAliases(value, replacements) {
  const aliases = replacements
    .flatMap(([source, canonical, placeholder]) => [
      [canonical, placeholder],
      [source, placeholder],
    ])
    .sort((left, right) => right[0].length - left[0].length);
  return aliases.reduce(
    (text, [source, placeholder]) =>
      text.replaceAll(source, placeholder).replaceAll(source.replaceAll('\\', '/'), placeholder),
    value,
  );
}
