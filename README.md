# +1 Daily — ChatGPT Plugin MVP

**One useful thing. Every day.**

+1 is a personalised micro-learning plugin for ChatGPT. It chooses one useful 3–5 minute lesson, teaches it interactively in ChatGPT, avoids repeating completed topics, and records demonstrated capabilities.

## Live private-beta MCP

`https://plus-one-daily-mcp.onrender.com/mcp`

## Core tools

- `get_daily_plus_one` — choose today's personalised topic
- `update_learning_profile` — save a lightweight learning profile
- `record_lesson_result` — record completion, feedback and capability
- `get_capability_passport` — review what the learner has demonstrated

## Privacy design

+1 does **not** download or reconstruct a user's full ChatGPT history. ChatGPT may pass a concise relevant context summary when personalisation is appropriate. The server stores only a lightweight learning profile and +1 learning history.

## Prototype hosting

The private beta is deployed on Render's free web-service plan in Singapore. Prototype state currently uses temporary local storage, so learning history can reset when the free service restarts or redeploys. Before public launch, move state to a proper database and add per-user authentication.

## Private testing

Connect the live MCP endpoint above in ChatGPT Developer Mode, then try:
- `Give me today's +1.`
- `Teach me one useful thing in five minutes.`
- `Show me my capability passport.`
