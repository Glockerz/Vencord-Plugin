/**
 * Resolve Vencord's build aliases to local mocks so the real plugin source can
 * be executed by plain `node --test` (no bundler, no Vencord checkout needed).
 *
 * It also fills in file extensions for relative imports: Vencord builds with
 * esbuild, which happily resolves `./engine`, while Node's ESM loader requires
 * the full filename.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const aliases = {
    "@webpack/common": new URL("./webpackCommonMock.ts", import.meta.url).href,
};

const extensions = [".ts", ".tsx", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, nextResolve) {
    const mapped = aliases[specifier];
    if (mapped) return { url: mapped, shortCircuit: true };

    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");

    try {
        return await nextResolve(specifier, context);
    } catch (err) {
        if (!isRelative || !context.parentURL) throw err;

        const parent = new URL(context.parentURL);
        for (const ext of extensions) {
            const candidate = new URL(specifier + ext, parent);
            if (existsSync(fileURLToPath(candidate))) {
                return { url: candidate.href, shortCircuit: true };
            }
        }
        throw err;
    }
}
