import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.send("SERVER RUNNING 🚀");
});

app.get("/api", (req, res) => {
  res.send("API WORKING 🚀");
});

app.listen(3000, "0.0.0.0", () => {
  console.log("Server running...");
});
