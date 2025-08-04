async function deductUserPoints(username, amount) {
  try {
    // 1. current balance
    const current = await getUserPoints(username);
    const newTotal = Math.max(0, current - Math.abs(amount));

    // 2. PUT – newTotal is the final path segment, body must be empty
    const res = await fetch(
      `${STREAM_ELEMENTS_API}/${STREAM_ELEMENTS_CHANNEL_ID}/${encodeURIComponent(username)}/${newTotal}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${STREAM_ELEMENTS_JWT}` }
      }
    );

    if (!res.ok) {
      console.error("[SE] PUT failed:", await res.text());
      return current;                 // keep old value on error
    }

    console.log(`[SE] ${username}: ${current} ➜ ${newTotal} (-${amount})`);
    return newTotal;                  // hand back fresh balance
  } catch (err) {
    console.error("[SE] deduct error:", err);
    return null;
  }
}
