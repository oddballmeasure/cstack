---
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Grep, Glob, Skill, Agent]
---

Tear this apart before it goes in. I'm offline right now. Do not try to reach GitHub or the network, and do not change any files. Just give me the result as text in your reply.

Intent: let a user withdraw from their wallet without ever going below zero, under concurrent requests.

```python
# wallet/service.py
async def withdraw(db, user_id: int, amount: int) -> int:
    row = await db.fetchrow("SELECT balance FROM wallets WHERE user_id = $1", user_id)
    if row["balance"] < amount:
        raise InsufficientFunds()
    await db.execute(
        "UPDATE wallets SET balance = $1 WHERE user_id = $2",
        row["balance"] - amount, user_id,
    )
    return row["balance"] - amount
```
