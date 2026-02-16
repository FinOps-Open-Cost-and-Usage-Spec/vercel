import crypto from 'crypto';

export default async function handler(req, res) {
  // --- 1. Security ---
  const signature = req.headers['x-hub-signature-256'];
  const hmac = crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(JSON.stringify(req.body)).digest('hex');

  if (signature !== digest) return res.status(401).send('Signature mismatch');

  // --- 2. Filter Event ---
  const { action, projects_v2_item, changes, sender } = req.body;
  
  // Only care about edits to items that are actually content (PRs/Issues)
  if (action !== 'edited' || !projects_v2_item?.content_node_id) {
    return res.status(200).send('Ignored: Not a relevant edit.');
  }

  // --- 3. Filter Field & Value ---
  const fieldName = changes?.field_value?.field_name;
  // Parse the "To" value (handle objects vs strings)
  const rawTo = changes?.field_value?.to;
  const newValue = (rawTo && typeof rawTo === 'object') ? rawTo.name : String(rawTo);

  // STRICT FILTER: Only "Status" changing to "PR Member Review"
  if (fieldName !== 'Status' || newValue !== 'PR Member Review') {
    return res.status(200).send(`Ignored: ${fieldName} -> ${newValue}`);
  }

  // --- 4. Fetch PR Details (GraphQL) ---
  // Project payloads don't have Title/URL, so we must fetch them.
  try {
    const query = `
      query($id: ID!) {
        node(id: $id) {
          ... on PullRequest { title url author { login } }
          ... on Issue { title url author { login } }
        }
      }
    `;

    const ghRes = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GH_PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables: { id: projects_v2_item.content_node_id } })
    });

    const { data } = await ghRes.json();
    const item = data?.node;

    if (!item) return res.status(404).send('Content not found on GitHub');

    // --- 5. Post to Slack ---
    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: "👀 Status Update: Member Review",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Moved to Member Review*\n<${item.url}|${item.title}>`
            }
          },
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: `Author: ${item.author.login} | Moved by: ${sender.login}` }]
          }
        ]
      })
    });

    return res.status(200).send('Slack notification sent.');

  } catch (error) {
    console.error(error);
    return res.status(500).send('Internal Server Error');
  }
}
