/** Where Deskwisp Cloud is (cloud/README.md): DESKWISP_CLOUD_URL points the app at another one (staging, or one running on this PC). */
export const cloudUrl = () => (process.env.DESKWISP_CLOUD_URL || "https://deskwisp.deskwisp.com/api").replace(/\/+$/, "");
