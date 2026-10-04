import type { StrapiApp } from "@strapi/strapi/admin";

if (
  typeof window !== "undefined" &&
  !window.localStorage.getItem("STRAPI_THEME")
) {
  window.localStorage.setItem("STRAPI_THEME", "light");
}

export default {
  config: {
    locales: ["tr"],
    theme: {
      light: {
        colors: {
          neutral0: "#ffffff",
          neutral100: "#f6f7f8",
          neutral150: "#eef0f2",
          neutral200: "#e4e7eb",
          neutral800: "#252a31",
          neutral900: "#181b20",
          neutral1000: "#111317",
        },
      },
    },
  },
  bootstrap(_app: StrapiApp) {},
};
