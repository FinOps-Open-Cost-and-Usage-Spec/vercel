import crypto from 'crypto';

export default async function handler(req, res) {
  // --- CONFIGURATION ---
  const TARGET_ORG = "FinOps-Open-Cost-and-Usage-Spec"; 
  const TARGET_PROJECT_NUMBER = 5; 
  const TARGET_FIELD_NAME = "Status"; 
  const TARGET_STATUS_VALUE = "PR Member Review"; 
  const TF_STATUS_VALUE = "PR TF Review"; 
  const TARGET_VIEW_URL = "https://github.com/orgs/FinOps-Open-Cost-and-Usage-Spec/projects/5/views/14";

  // --- 1. Security ---
  if (!process.env.GITHUB_WEBHOOK_SECRET) return res.status(500).send('Missing Secret');

  const signature = req.headers['x-hub-signature-256'];
  const hmac = crypto.createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(JSON.stringify(req.body)).digest('hex');

  if (signature !== digest) {
    console.error('Signature mismatch');
    return res.status(401).send('Signature mismatch');
  }

  // --- 2. Filter Payload ---
  const { action, projects_v2_item, changes, organization } = req.body;

  if (organization?.login !== TARGET_ORG) {
    return res.status(200).send(`Ignored: Org is ${organization?.login}`);
  }

  if (action !== 'edited' || !projects_v2_item?.content_node_id) {
    return res.status(200).send('Ignored: Not a relevant edit.');
  }

  const fieldName = changes?.field_value?.field_name;
  const rawTo = changes?.field_value?.to;
  const newValue = (rawTo && typeof rawTo === 'object') ? rawTo.name : String(rawTo || "");

  console.log(`Field Modified: ${fieldName} -> ${newValue}`);

  if (fieldName !== TARGET_FIELD_NAME) {
    return res.status(200).send(`Ignored: Modified field was ${fieldName}`);
  }

  if (newValue !== TARGET_STATUS_VALUE) {
    return res.status(200).send(`Ignored: Status changed to ${newValue}`);
  }

  // --- 3. Fetch Details AND Counts ---
  try {
    const query = `
      query($contentId: ID!, $projectId: ID!) {
        project: node(id: $projectId) {
          ... on ProjectV2 {
            number
            title
            
            # Count PRs only (is:pr) in Member Review
            memberReviewCount: items(first: 0, query: "status:\\"${TARGET_STATUS_VALUE}\\" is:open is:pr") {
              totalCount
            }
            
            # Count PRs only (is:pr) in TF Review
            tfReviewCount: items(first: 0, query: "status:\\"${TF_STATUS_VALUE}\\" is:open is:pr") {
              totalCount
            }
          }
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

    if (project?.number !== TARGET_PROJECT_NUMBER) {
      return res.status(200).send(`Ignored: Board #${project?.number}, wanted #${TARGET_PROJECT_NUMBER}`);
    }

    if (!item) return res.status(404).send('Content not found on GitHub');

    const memberCount = project.memberReviewCount.totalCount;
    const tfCount = project.tfReviewCount.totalCount;

    // --- 4. Post to Slack ---
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
                text: `Author: ${item.author.login}`
              }
            ]
          },
          {
            type: "divider"
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                // All on one line now, separated by pipes
                text: `*Current Queue:* 👤 *${memberCount}* in Member Review  |  🤖 *${tfCount}* in TF Review  |  See <${TARGET_VIEW_URL}|here> for a list of all PRs`
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
