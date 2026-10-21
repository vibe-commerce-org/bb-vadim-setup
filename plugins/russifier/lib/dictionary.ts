// The dictionaries baked into the app bundle (see dict/README.md for what
// each file holds). Later files win on the same key: extra.json fixes go last.
import builtin from "../dict/builtin.json";
import core from "../dict/core.json";
import extra from "../dict/extra.json";
import vibecom from "../dict/vibecom.json";
import { Engine } from "./engine.ts";

export function createEngine(): Engine {
  return new Engine(core, builtin, vibecom, extra);
}
