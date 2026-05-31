# Gmail Credentials Setup

This directory holds two files:

| File | Description |
|------|-------------|
| `credentials.json` | OAuth 2.0 client credentials — **you create this once** |
| `token.json` | Saved access/refresh token — **auto-generated on first run** |

Both files are git-ignored. Never commit them.

---

## One-time setup (5 minutes)

### 1. Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com).
2. Click **Select a project → New Project**, give it a name (e.g. `gmail-task-agent`), click **Create**.

### 2. Enable the Gmail API

1. In the left sidebar go to **APIs & Services → Library**.
2. Search for **Gmail API** and click **Enable**.

### 3. Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External**, click **Create**.
3. Fill in:
   - App name: `Gmail Task Agent`
   - User support email: your Gmail address
   - Developer contact email: your Gmail address
4. Click **Save and Continue** through the remaining steps (no scopes needed here).
5. On the **Test users** page add your Gmail address, then click **Save and Continue**.

### 4. Create OAuth 2.0 credentials

1. Go to **APIs & Services → Credentials**.
2. Click **+ Create Credentials → OAuth client ID**.
3. Application type: **Desktop app**.
4. Name: `gmail-task-agent-desktop` (or anything you like).
5. Click **Create**.
6. Click **Download JSON** on the confirmation dialog.
7. Rename the downloaded file to `credentials.json` and place it in this directory:

```
gmail-agent/credentials/credentials.json   ← here
```

### 5. First run — authorise the app

```bash
npm run gmail-agent
```

The agent will print an authorisation URL. Open it in your browser, sign in with your Google account, grant access, then copy the code and paste it back into the terminal.

A `token.json` file will be saved automatically. Subsequent runs skip this step.

---

## Revoking access

To revoke access, visit [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and remove **Gmail Task Agent**. Delete `token.json` locally as well.
