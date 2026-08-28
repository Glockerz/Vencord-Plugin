/**
 * Resolve Vencord's build aliases to local mocks so the real plugin source can
 * be executed by plain `node --test` (no bundler, no Vencord checkout needed).
 */

const aliases = {
    "@webpack/common": new URL("./webpackCommonMock.ts", import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
    const mapped = aliases[specifier];
    if (mapped) return { url: mapped, shortCircuit: true };
    return nextResolve(specifier, context);
}
