#!/usr/bin/env node

import { parseArgs } from "node:util";
import {
  DEFAULT_TEMPLATE,
  PRESETS,
  TOPIC_MAX_LENGTH,
  TOPIC_MIN_LENGTH,
  defaultConfigPath,
  frame,
  parseTemplate,
  readConfig,
  writeConfig,
} from "./lib/title-template.mjs";

const USAGE = "usage: title-template.mjs show | preview --template <template> | save --template <template> [--config <path>]";

function describe(source, now) {
  const { prefix, suffix } = frame(parseTemplate(source), now);
  return { template: source, example: `${prefix}<topic>${suffix}` };
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      strict: true,
      allowPositionals: true,
      options: {
        config: { type: "string", default: defaultConfigPath() },
        template: { type: "string" },
      },
    });
  } catch (error) {
    throw new Error(`arguments failed (${error.code || "parse error"})`);
  }
  const { values, positionals } = parsed;
  const [command, ...extra] = positionals;
  if (extra.length || !["show", "preview", "save"].includes(command)) throw new Error(USAGE);
  if ((command === "show") !== (values.template === undefined)) throw new Error(USAGE);
  const now = Date.now();

  if (command === "save") writeConfig(values.config, values.template);
  const saved = readConfig(values.config);
  const result = {
    configPath: values.config,
    configured: saved.configured,
    active: describe(saved.template, now),
    topicLength: { min: TOPIC_MIN_LENGTH, max: TOPIC_MAX_LENGTH },
  };
  if (command === "preview") result.preview = describe(values.template, now);
  if (command === "show") {
    result.default = DEFAULT_TEMPLATE;
    result.presets = PRESETS.map(({ id, template }) => ({ id, ...describe(template, now) }));
  }
  process.stdout.write(JSON.stringify(result));
}

try {
  main();
} catch (error) {
  process.stderr.write(`title-template failed: ${error.message}\n`);
  process.exitCode = 1;
}
