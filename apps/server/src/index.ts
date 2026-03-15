import { buildApp } from "./app";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";

const main = async () => {
  const { app } = await buildApp();

  await app.listen({ port, host });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
