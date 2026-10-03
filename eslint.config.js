import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["packages/*/src/**/*.ts"],
    rules: {
      // KRW amounts are bigint integers only. Guard against float-style arithmetic creeping in.
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Money is bigint KRW; never parse floats." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Number", property: "parseFloat", message: "Money is bigint KRW; never parse floats." },
        { object: "Math", property: "round", message: "No rounding: money is bigint KRW integers." },
        { object: "Math", property: "floor", message: "No rounding: money is bigint KRW integers." },
        { object: "Math", property: "ceil", message: "No rounding: money is bigint KRW integers." },
      ],
    },
  },
);
