import config from "@/config/config.json";

const base =
  config.site.base_path === "/"
    ? ""
    : config.site.base_path.replace(/\/+$/, "");

// Prefix an internal path with the configured base path (e.g. "/blog").
// External URLs, anchors, and mailto links are returned unchanged.
export const url = (path: string = "/"): string => {
  if (
    !path ||
    /^(https?:)?\/\//.test(path) ||
    path.startsWith("#") ||
    path.startsWith("mailto:")
  ) {
    return path;
  }
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `${base}${clean}`;
};
