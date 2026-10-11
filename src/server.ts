import app from "./app.js";

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  // Startup metadata only; ticket payloads are never logged.
  console.log(`Dhaba triage demo listening on port ${port}`);
});
