const { app } = require("electron");

process.stdout.write("loaded\n");
app.whenReady().then(() => {
  process.stdout.write("ready\n");
  app.quit();
});
