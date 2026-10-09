#!/usr/bin/env node
import fs from "node:fs";
import solc from "solc";
if (process.argv.includes("--version")) {
    console.log(
        `solc, the solidity compiler commandline interface\nVersion: ${solc.version()}`,
    );
} else if (process.argv.includes("--standard-json")) {
    process.stdout.write(
        solc.compile(fs.readFileSync(0, "utf8"), {
            import: (name) => {
                for (const file of [name, `node_modules/${name}`])
                    if (fs.existsSync(file))
                        return { contents: fs.readFileSync(file, "utf8") };
                return { error: `Missing import ${name}` };
            },
        }),
    );
} else {
    console.error("Use --version or --standard-json");
    process.exit(1);
}
