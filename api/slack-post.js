import crypto from 'crypto';

export default async function handler(req, res) {
  // --- CONFIGURATION ---
  const TARGET_ORG = "FinOps-Open-Cost-and-Usage-Spec"; 
  const TARGET_PROJECT_NUMBER = 5; // Board #5
  const TARGET_COLUMN = "PR Member Review"; 

  // --- 1. Security ---
  const GITHUB_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
  const signature = req.headers['x-hub-signature-256'];
  const hmac = crypto.createHmac('sha256', GITHUB_SECRET);
  const digest = 'sha256=' + hmac.update(JSON.stringify(req.body)).digest('hex');

  if (signature !== digest) return res.status(401).send('Signature mismatch');

  // --- 2. Filter Payload ---
  const { action, projects_v2_item, changes, organization } = req.body;

  // A. Quick Organization Check
  if (organization?.login !== TARGET_ORG) {
    return res.status(200).send(`Ignored: Org is ${organization?.login}`);
  }

  // B. Basic Event Checks
  if (action !== 'edited' || !projects_v2_item?.content_node_id) {
    return res.status(200).send('Ignored: Not a relevant edit.');
  }

  // C. Field & Value Check
  const fieldName = changes?.field_value?.field_name;
  const rawTo = changes?.field_value?.to;
  const newValue = (rawTo && typeof rawTo === 'object') ? rawTo.name : String(rawTo);

  if (fieldName !== 'Status' || newValue !== TARGET_COLUMN) {
    return res.status(200).send(`Ignored: Field ${fieldName} -> ${newValue}`);
  }

  // --- 3. Verify Project Number & Fetch PR Details ---
  try {
    const query = `
      query($contentId: ID!, $projectId: ID!) {
        project: node(id: $projectId) {
          ... on ProjectV2 { number }
        }
        item: node(id: $contentId) {
          ... on PullRequest {
            number
            title
            url
            author { login }
          }
          ... on Issue {
            number
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
    const project = data?.project;
    const item = data?.item;

    // Verify Board Number is 5
    if (project?.number !== TARGET_PROJECT_NUMBER) {
      return res.status(200).send(`Ignored: Board #${project?.number}, wanted #${TARGET_PROJECT_NUMBER}`);
    }

    if (!item) return res.status(404).send('Content not found on GitHub');

    // --- 4. Post to Slack (Fancier Format) ---
    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // "text" is the fallback notification content for mobile push/sidebar
        text: `🔔 PR #${item.number} Ready for Member Review`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `🔔 *PR <${item.url}|#${item.number}> is now ready for Member review!*`
            }
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `> *${item.title}*` 
            }
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `Author: ${item.author.login}`
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
