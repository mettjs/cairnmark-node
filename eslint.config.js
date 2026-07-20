import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // The upload/response surfaces genuinely traffic in unknown JSON.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
