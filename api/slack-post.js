import crypto from 'crypto';

export default async function handler(req, res) {
  // --- CONFIGURATION ---
  const TARGET_ORG = "FinOps-Open-Cost-and-Usage-Spec"; // Your Org Name
  const TARGET_PROJECT_NUMBER = 5; // Your Project Number (e.g. "Board #15")
  const TARGET_COLUMN = "PR Member Review"; // The exact column name to watch

  // --- 1. Security ---
  const signature = req.headers['x-hub-signature-256'];
  const hmac = crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(JSON.stringify(req.body)).digest('hex');

  if (signature !== digest) return res.status(401).send('Signature mismatch');

  // --- 2. Filter Payload ---
  const { action, projects_v2_item, changes, sender, organization } = req.body;

  // A. Quick Organization Check
  // (Prevents processing events from other orgs if you reuse the webhook)
  if (organization?.login !== TARGET_ORG) {
    return res.status(200).send(`Ignored: Org is ${organization?.login}, wanted ${TARGET_ORG}`);
  }

  // B. Basic Event Checks
  if (action !== 'edited' || !projects_v2_item?.content_node_id) {
    return res.status(200).send('Ignored: Not a relevant edit.');
  }

  // C. Field & Value Check
  const fieldName = changes?.field_value?.field_name;
  const rawTo = changes?.field_value?.to;
  // Parse the "To" value (Project V2 sends objects for Single Select fields)
  const newValue = (rawTo && typeof rawTo === 'object') ? rawTo.name : String(rawTo);

  if (fieldName !== 'Status' || newValue !== TARGET_COLUMN) {
    return res.status(200).send(`Ignored: Field ${fieldName} changed to ${newValue}`);
  }

  // --- 3. Verify Project Number & Fetch PR Details ---
  try {
    // GraphQL Query: Get Project Number AND PR Details in one go
    const query = `
      query($contentId: ID!, $projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            number
            title
          }
        }
        item: node(id: $contentId) {
          ... on PullRequest {
            title
            url
            author { login }
          }
          ... on Issue {
            title
            url
            author { login }
          }
        }
      }
    `;

    const ghRes = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GH_PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: {
          contentId: projects_v2_item.content_node_id,
          projectId: projects_v2_item.project_node_id
        }
      })
    });

    const { data } = await ghRes.json();
    const project = data?.node;
    const item = data?.item;

    // D. Verify Project Number matches target
    if (project?.number !== TARGET_PROJECT_NUMBER) {
      return res.status(200).send(`Ignored: Event from Project #${project?.number}, wanted #${TARGET_PROJECT_NUMBER}`);
    }

    if (!item) return res.status(404).send('Content not found on GitHub');

    // --- 4. Post to Slack ---
    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `👀 Status Update: ${TARGET_COLUMN}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Moved to ${TARGET_COLUMN}*\n<${item.url}|${item.title}>`
            }
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `Author: ${item.author.login} | Board: ${project.title} (#${project.number})`
              }
            ]
          }
        ]
      })
    });

    return res.status(200).send('Success: Slack notification sent.');

  } catch (error) {
    console.error(error);
    return res.status(500).send('Internal Server Error');
  }
}
