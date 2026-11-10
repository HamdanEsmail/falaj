// The document around the page: title, fonts, the stylesheet and the three scripts. Every script is
// a file of this site (the content security policy allows no inline script), and the page reads
// the same without them.
import { raw } from "hono/html";
import type { Child } from "hono/jsx";

const SWITZER = "https://api.fontshare.com/v2/css?f[]=switzer@400,500,600&display=swap";
const KUFI = "https://fonts.googleapis.com/css2?family=Noto+Kufi+Arabic:wght@600&display=swap";

export function Layout(props: { title: string; description: string; base: string; children: Child }) {
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>{props.title}</title>
          <meta name="description" content={props.description} />
          <meta name="author" content="Hamdan Esmail" />
          <link rel="canonical" href={`${props.base}/`} />
          <meta property="og:title" content={props.title} />
          <meta property="og:description" content={props.description} />
          <meta property="og:image" content={`${props.base}/assets/social.jpg`} />
          <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
          <link rel="preconnect" href="https://api.fontshare.com" />
          <link rel="preconnect" href="https://cdn.fontshare.com" crossorigin="anonymous" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
          <link href={SWITZER} rel="stylesheet" />
          <link href={KUFI} rel="stylesheet" />
          <link rel="stylesheet" href="/assets/site.css" />
          <script src="/assets/js-on.js"></script>
          <script src="/assets/site.js" defer></script>
          <script src="/assets/wait.js" defer></script>
        </head>
        <body>{props.children}</body>
      </html>
    </>
  );
}
