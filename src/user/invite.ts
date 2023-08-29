// eslint-disable-next-line @typescript-eslint/no-unused-vars
import async from 'async';
import nconf from 'nconf';
import validator from 'validator';

import DbModule from '../database';
import meta from '../meta';
import emailer from '../emailer';
import groups from '../groups';
import translator from '../translator';
import utils from '../utils';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import plugins from '../plugins';

interface InvitationQuery {
    token: string;
}

interface UserObject {
    getUidByEmail(email: string): Promise<string | null>;
    exists(uid: string): Promise<boolean>;
    getUserField(uid: string, field: string): Promise<string>;
    getInvites(uid: string): Promise<string[]>;
    getInvitesNumber(uid: string): Promise<number>;
    getInvitingUsers(): Promise<string[]>;
    getAllInvites(uid: string): Promise<{ uid: string, invitations: string[] }[]>;
    sendInvitationEmail(uid: string, email: string, groupsToJoin: string[]): Promise<void>;
    verifyInvitation(query: InvitationQuery): Promise<void>;
    confirmIfInviteEmailIsUsed(token: string, enteredEmail: string, uid: string): Promise<void>;
    confirmByUid(uid: string): Promise<void>;
    joinGroupsFromInvitation(uid: string, token: string): Promise<void>;
    deleteInvitation(invitedBy: string, email: string): Promise<void>;
    getUidByUsername(username: string): Promise<string | null>;
    deleteInvitationKey(registrationEmail: string, token: string): Promise<void>;
}

interface DbModule {
    setRemove(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    setCount(key: string): Promise<number>;
    getSetMembers(key: string): Promise<string[]>;
    exists(key: string): Promise<boolean>;
    getObjectField(key: string, field: string): Promise<string | null>;
    getObject(key: string): Promise<Invite | null>;
    deleteAll(keys: string[]): Promise<void>;
    setAdd(key: string, value: string): Promise<void>;
    setObject(key: string, data: Invitation): Promise<void>;
    pexpireAt(key: string, timestamp: number): Promise<void>;
    set(key: string, value: Invitation): Promise<void>;
    get(key: string): Promise<string | null>;
}

interface Invite {
    inviter: string;
    email: string;
}

interface Invitation {
    email: string;
    token: string;
    groupsToJoin: string[];
    inviter: string;
}

interface MetaConfig {
    registrationType: string;
    defaultLang: string;
    inviteExpiration: number;
    title?: string;
    browserTitle?: string;
}

interface GroupsModule {
    join(groupsToJoin: string[], uid: string): Promise<void>;
}

interface Utils {
    generateUUID(): string;
}

declare const utils: Utils;
declare const groups: GroupsModule;

const metaConfig: MetaConfig = meta.config as MetaConfig;
const db: DbModule = DbModule as DbModule;

export = function (User: UserObject) {
    User.getInvites = async function (uid: string): Promise<string[]> {
        const emails: string[] = await db.getSetMembers(`invitation:uid:${uid}`);
        return emails.map((email: string) => validator.escape(String(email)));
    };

    User.getInvitesNumber = async function (uid: string) {
        return await db.setCount(`invitation:uid:${uid}`);
    };

    User.getInvitingUsers = async function () {
        return await db.getSetMembers('invitation:uids');
    };

    User.getAllInvites = async function () {
        const uids = await User.getInvitingUsers();
        const invitationsPromises = uids.map(async (uid: string) => {
            const invites = await User.getInvites(uid);
            return { uid, invitations: invites };
        });
        return Promise.all(invitationsPromises);
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async function deleteFromReferenceList(uid: string, email: string): Promise<void> {
        await Promise.all([
            await db.setRemove(`invitation:uid:${uid}`, email),
            await db.delete(`invitation:uid:${uid}:invited:${email}`),
        ]);
        const count = await db.setCount(`invitation:uid:${uid}`);
        if (count === 0) {
            await db.setRemove('invitation:uids', uid);
        }
    }

    User.confirmIfInviteEmailIsUsed = async function (token: string, enteredEmail: string, uid: string) {
        if (!enteredEmail) {
            return;
        }
        const email = await db.getObjectField(`invitation:token:${token}`, 'email');
        // "Confirm" user's email if registration completed with invited address
        if (email && email === enteredEmail) {
            await User.confirmByUid(uid);
        }
    };

    User.joinGroupsFromInvitation = async function (uid: string, token: string) {
        const groupsToJoinJson: string | null = await db.getObjectField(`invitation:token:${token}`, 'groupsToJoin');

        if (!groupsToJoinJson) {
            return;
        }

        let groupsToJoin: string[] = [];
        try {
            groupsToJoin = JSON.parse(groupsToJoinJson) as string[]; // Cast to string[]
        } catch (e) {
            return;
        }

        if (groupsToJoin.length < 1) {
            return;
        }

        await groups.join(groupsToJoin, uid);
    };


    User.deleteInvitation = async function (invitedBy: string, email: string): Promise<void> {
        const invitedByUid = await User.getUidByUsername(invitedBy);
        if (!invitedByUid) {
            throw new Error('[[error:invalid-username]]');
        }
        const token = await db.get(`invitation:uid:${invitedByUid}:invited:${email}`);
        await Promise.all([
            deleteFromReferenceList(invitedByUid, email),
            db.setRemove(`invitation:invited:${email}`, token),
            db.delete(`invitation:token:${token}`),
        ]);
    };

    User.deleteInvitationKey = async function (registrationEmail: string, token: string): Promise<void> {
        if (registrationEmail) {
            const uids = await User.getInvitingUsers();
            await Promise.all(uids.map(uid => deleteFromReferenceList(uid, registrationEmail)));
            // Delete all invites to an email address if it has joined
            const tokens = await db.getSetMembers(`invitation:invited:${registrationEmail}`);
            const keysToDelete = [`invitation:invited:${registrationEmail}`, ...tokens.map(token => `invitation:token:${token}`)];
            await db.deleteAll(keysToDelete);
        }
        if (token) {
            const invite = await db.getObject(`invitation:token:${token}`);
            if (!invite) {
                return;
            }
            await deleteFromReferenceList(invite.inviter, invite.email);
            await db.deleteAll([
                `invitation:invited:${invite.email}`,
                `invitation:token:${token}`,
            ]);
        }
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async function prepareInvitation(uid: string, email: string, groupsToJoin: string[]) {
        const inviterExists = await User.exists(uid);
        if (!inviterExists) {
            throw new Error('[[error:invalid-uid]]');
        }

        // const title: string = metaConfig.title || metaConfig.browserTitle || 'NodeBB';
        const token = utils.generateUUID();
        const registerLink = `${nconf.get('url') as string}/register?token=${token}`;
        const expireDays: number = metaConfig.inviteExpiration;
        const expireIn = expireDays * 86400000;
        // const username = await User.getUserField(uid, 'username');
        // const subject = await translator.translate(`[[email:invite, ${title}]]`, metaConfig.defaultLang);

        await db.setAdd(`invitation:uid:${uid}`, email);
        await db.setAdd('invitation:uids', uid);
        // Referencing from uid and email to token
        await db.set(`invitation:uid:${uid}:invited:${email}`, {
            email,
            token,
            groupsToJoin,
            inviter: uid,
        } as Invitation);
        // Keeping references for all invites to this email address
        await db.setAdd(`invitation:invited:${email}`, token);
        await db.setObject(`invitation:token:${token}`, {
            email,
            token,
            groupsToJoin, // array of strings
            inviter: uid,
        });
        await db.pexpireAt(`invitation:token:${token}`, Date.now() + expireIn);

        const defaultLang: string = metaConfig.defaultLang || 'en';
        const username: string = await User.getUserField(uid, 'username');
        const title: string = metaConfig.title || metaConfig.browserTitle || 'NodeBB';
        const subject: string = await translator.translate(`[[email:invite, ${title}]]`, defaultLang);
        return {
            ...emailer._defaultPayload,
            site_title: title,
            registerLink: registerLink,
            subject: subject,
            username: username,
            template: 'invitation',
            expireDays: expireDays,
        };
    }
};
