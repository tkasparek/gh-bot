import { EventPayloads, WebhookEvent } from '@octokit/webhooks';
import { Context, Probot } from 'probot';
import JiraApi from 'jira-client';

const jiraRegex = process.env.JIRA_REGEXP || /(VULN|SPM|VMAAS|VULN4OS)-[0-9]+/g;

const BEAERER = process.env.JIRA_TOKEN;

if (BEAERER === undefined) {
    console.info('Jira token is missing, skipping version marking in Jira');
}

const jiraAPI = new JiraApi({
    protocol: 'https',
    host: 'issues.redhat.com',
    bearer: BEAERER,
    apiVersion: '2',
    strictSSL: true,
});

const checkComments = async (
    context: WebhookEvent<EventPayloads.WebhookPayloadPullRequest> & Omit<Context<any>, keyof WebhookEvent<any>>
): Promise<number | undefined> => {
    const comments = await context.octokit.issues.listComments({
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        issue_number: context.payload.pull_request.number,
    });
    for (const comment of comments.data.reverse()) {
        if (comment.user?.id === 88086763) {
            return comment.id;
        }
    }

    return undefined;
};

const processPR = async (context: WebhookEvent<EventPayloads.WebhookPayloadPullRequest> & Omit<Context<any>, keyof WebhookEvent<any>>) => {
    const missingJiraIDs = new Set<string>();
    const jiraIds = new Set<string>();

    const response = await context.octokit.pulls.listCommits({
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        pull_number: context.payload.pull_request.number,
    });

    response.data.forEach((commit) => {
        const match = commit.commit.message.match(jiraRegex);
        if (match === null) {
            missingJiraIDs.add(commit.sha);
        } else {
            match.forEach((jiraId) => {
                jiraIds.add(jiraId);
            });
        }
    });

    let responseBody = '';
    if (missingJiraIDs.size > 0) {
        responseBody = responseBody + 'Commits missing Jira IDs:\n';
        missingJiraIDs.forEach((commit) => {
            responseBody = responseBody + commit + '\n';
        });
    }
    if (jiraIds.size > 0) {
        responseBody = responseBody + 'Referenced Jiras:\n';
        jiraIds.forEach((jiraId) => {
            responseBody = responseBody + 'https://issues.redhat.com/browse/' + jiraId + '\n';
        });
    }

    const commentId = await checkComments(context);
    if (commentId !== undefined) {
        await context.octokit.issues.updateComment({
            body: responseBody,
            owner: context.payload.repository.owner.login,
            repo: context.payload.repository.name,
            comment_id: commentId,
        });
        console.log('updated comment at: ', context.payload.pull_request.html_url);
    } else {
        const comment = context.issue({ body: responseBody });
        await context.octokit.issues.createComment(comment);
        console.log('created comment at: ', context.payload.pull_request.html_url);
    }
};

const processPush = async (context: WebhookEvent<EventPayloads.WebhookPayloadPush> & Omit<Context<any>, keyof WebhookEvent<any>>) => {
    const headCommit = context.payload.head_commit;
    if (headCommit === null) {
        return;
    }
    if (headCommit['author']['name'] !== 'semantic-release') {
        return;
    }

    let commit;
    const headCommitDetails = await context.octokit.repos.getCommit({
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        ref: context.payload.ref,
    });
    const version = headCommitDetails.data.commit.message.split('\n')[0];
    let ref = headCommitDetails.data.parents[0].sha;

    const jiraIds = new Set<string>();
    do {
        commit = await context.octokit.repos.getCommit({
            owner: context.payload.repository.owner.login,
            repo: context.payload.repository.name,
            ref,
        });
        if (commit.data.parents.length === 0) {
            break;
        }
        ref = commit.data.parents[0].sha;

        const match = commit.data.commit.message.match(jiraRegex);
        if (match !== null) {
            match.forEach((jiraId) => {
                jiraIds.add(jiraId);
            });
        }
    } while (commit.data.commit.author?.name !== 'semantic-release');

    console.log(`Version ${version} fixes: `, jiraIds);

    if (jiraIds.size === 0) {
        return;
    }
    let projectId;
    let projectKey;
    const issue = await jiraAPI.findIssue(jiraIds.values().next().value);
    projectId = issue.fields.project.id;
    projectKey = issue.fields.project.key;

    let versionId: number;
    const knownVersions = await jiraAPI.getVersions(projectKey);
    const filteredVersions = knownVersions.filter((item: { name: string; id: number }) => item.name === version);
    if (filteredVersions.length === 0) {
        const res = await jiraAPI.createVersion({
            archived: false,
            name: version,
            description: Array.from(jiraIds).join(' '),
            projectId: projectId,
            released: false,
        });
        versionId = res.id;
    } else {
        versionId = filteredVersions[0].id;
    }

    jiraIds.forEach((issue) => {
        jiraAPI.updateIssue(issue, { fields: { fixVersions: [{ id: versionId.toString() }] } });
    });
};

export = (app: Probot) => {
    app.on('pull_request.opened', async (context) => processPR(context));
    app.on('pull_request.synchronize', async (context) => processPR(context));
    if (BEAERER !== undefined) {
        app.on('push', async (context) => processPush(context));
    }
};
