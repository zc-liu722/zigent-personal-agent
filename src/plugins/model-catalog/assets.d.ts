declare module "#model-assets" {
  const variants: Readonly<Record<"local" | "production", unknown>>;
  export default variants;
}
