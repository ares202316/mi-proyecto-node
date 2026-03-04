require("dotenv").config();
const express = require("express");
const apiRoute = require("./routes/routes");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use("/whatsapp", apiRoute);

app.listen(PORT, () => {
  console.log("el puerto es: " + PORT);
});

const pool = require("./db");

app.get("/db-test", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW() as now");
    res.json(r.rows[0]);
  } catch (e) {
    console.log(e);
    res.status(500).json({ error: "DB connection failed" });
  }
});