import { createRequire } from "node:module";

export type * from "../../../target/zk/private-fundraiser-program/wasm-node/private_fundraiser_program.js";

type FundraiserWasm =
  typeof import("../../../target/zk/private-fundraiser-program/wasm-node/private_fundraiser_program.js");

export const wasm: FundraiserWasm = createRequire(import.meta.url)(
  "../../../target/zk/private-fundraiser-program/wasm-node/private_fundraiser_program.js",
);
