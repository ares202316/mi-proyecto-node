const pool = require("../db");

async function getState(wa_id) {
  const r = await pool.query(
    "SELECT wa_id, state, temp FROM conversation_state WHERE wa_id=$1",
    [wa_id]
  );
  return r.rows[0] || null;
}

async function setState(wa_id, state, temp = {}) {
  const r = await pool.query(
    `INSERT INTO conversation_state (wa_id, state, temp, updated_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (wa_id)
     DO UPDATE SET state=EXCLUDED.state, temp=EXCLUDED.temp, updated_at=NOW()
     RETURNING wa_id, state, temp`,
    [wa_id, state, temp]
  );
  return r.rows[0];
}

async function clearState(wa_id) {
  await pool.query("DELETE FROM conversation_state WHERE wa_id=$1", [wa_id]);
}

module.exports = { getState, setState, clearState };