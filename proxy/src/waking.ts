export function wakingPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="3" />
    <title>Waking sandbox…</title>
    <style>
      html, body { height: 100%; margin: 0; }
      body {
        display: grid;
        place-items: center;
        font-family: ui-sans-serif, system-ui, sans-serif;
        background: #0b1220;
        color: #e8eefc;
      }
      p { letter-spacing: 0.02em; }
    </style>
  </head>
  <body>
    <p>Waking sandbox…</p>
  </body>
</html>`;
}
