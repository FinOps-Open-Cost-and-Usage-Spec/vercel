import crypto from 'crypto';

export default async function handler(req, res) {
  // --- CONFIGURATION ---
  const TARGET_ORG = "FinOps-Open-Cost-and-Usage-Spec"; 
  const TARGET_PROJECT_NUMBER = 5; 
  const TARGET_FIELD_NAME = "Status"; // The column header
  const TARGET_STATUS_VALUE = "PR Member Review"; // The value to trigger on

  // --- 1. Security (HMAC) ---
  const signature = req.headers['x-hub-signature-256'];
  const hmac = crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(JSON.stringify(req.body)).digest('hex');

  if (signature !== digest) {
    console.error('Signature mismatch');
    return res.status(401).send('Signature mismatch');
  }

  // --- 2. Parse Payload ---
  const { action, projects_v2_item, changes, organization } = req.body;

  // A. Quick Org Check
  if (organization?.login !== TARGET_ORG) {
    return res.status(200).send(`Ignored: Org is ${organization?.login}`);
  }

  // B. Event Relevance Check
  // We only care if an item was edited and has content (is a PR/Issue)
  if (action !== 'edited' || !projects_v2_item?.content_node_id) {
    return res.status(200).send('Ignored: Not a relevant edit.');
  }

  // --- 3. The Logic Check ---
  const fieldName = changes?.field_value?.field_name;
  
  // Safely extract the new value (GitHub sends objects for single-select fields)
  const rawTo = changes?.field_value?.to;
  const newValue = (rawTo && typeof rawTo === 'object') ? rawTo.name : String(rawTo || "");

  // Debug Log (View this in Vercel Logs if it doesn't fire)
  console.log(`Field Modified: ${fieldName} -> ${newValue}`);

  if (fieldName !== TARGET_FIELD_NAME) {
    return res.status(200).send(`Ignored: Modified field was ${fieldName}`);
  }

  if (newValue !== TARGET_STATUS_VALUE) {
    return res.status(200).send(`Ignored: Status changed to ${newValue}`);
  }

  // --- 4. Fetch Details from GitHub ---
  try {
    const query = `
      query($contentId: ID!, $projectId: ID!) {
        project: node(id: $projectId) {
          ... on ProjectV2 { number title }
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

    // Verify Board Number matches our Target
    if (project?.number !== TARGET_PROJECT_NUMBER) {
      return res.status(200).send(`Ignored: Board #${project?.number}, wanted #${TARGET_PROJECT_NUMBER}`);
    }

    if (!item) return res.status(404).send('Content not found on GitHub');

    // --- 5. Post to Slack ---
    const slackRes = await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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
                text: `Author: ${item.author.login} | Board: ${project.title}`
              }
            ]
          }
        ]
      })
    });

    if (!slackRes.ok) {
       console.error('Slack API Error:', await slackRes.text());
       return res.status(500).send('Failed to send to Slack');
    }

    return res.status(200).send('Success: Slack notification sent.');

  } catch (error) {
    console.error('Handler Error:', error);
    return res.status(500).send('Internal Server Error');
  }
}
