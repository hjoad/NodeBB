"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const nconf_1 = __importDefault(require("nconf"));
const validator_1 = __importDefault(require("validator"));
const database_1 = __importDefault(require("../database"));
const meta_1 = __importDefault(require("../meta"));
const emailer_1 = __importDefault(require("../emailer"));
const translator_1 = __importDefault(require("../translator"));
const plugins_1 = __importDefault(require("../plugins"));
const metaConfig = meta_1.default.config;
const db = database_1.default;
module.exports = function (User) {
    User.getInvites = async function (uid) {
        const emails = await db.getSetMembers(`invitation:uid:${uid}`);
        return emails.map((email) => validator_1.default.escape(String(email)));
    };
    User.getInvitesNumber = async function (uid) {
        return await db.setCount(`invitation:uid:${uid}`);
    };
    User.getInvitingUsers = async function () {
        return await db.getSetMembers('invitation:uids');
    };
    User.getAllInvites = async function () {
        const uids = await User.getInvitingUsers();
        const invitationsPromises = uids.map(async (uid) => {
            const invites = await User.getInvites(uid);
            return { uid, invitations: invites };
        });
        return Promise.all(invitationsPromises);
    };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async function prepareInvitation(uid, email, groupsToJoin) {
        const inviterExists = await User.exists(uid);
        if (!inviterExists) {
            throw new Error('[[error:invalid-uid]]');
        }
        // const title: string = metaConfig.title || metaConfig.browserTitle || 'NodeBB';
        const token = utils.generateUUID();
        const registerLink = `${nconf_1.default.get('url')}/register?token=${token}`;
        const expireDays = metaConfig.inviteExpiration;
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
        });
        // Keeping references for all invites to this email address
        await db.setAdd(`invitation:invited:${email}`, token);
        await db.setObject(`invitation:token:${token}`, {
            email,
            token,
            groupsToJoin,
            inviter: uid,
        });
        await db.pexpireAt(`invitation:token:${token}`, Date.now() + expireIn);
        const defaultLang = metaConfig.defaultLang || 'en';
        const username = await User.getUserField(uid, 'username');
        const title = metaConfig.title || metaConfig.browserTitle || 'NodeBB';
        const subject = await translator_1.default.translate(`[[email:invite, ${title}]]`, defaultLang);
        return Object.assign(Object.assign({}, emailer_1.default._defaultPayload), { site_title: title, registerLink: registerLink, subject: subject, username: username, template: 'invitation', expireDays: expireDays });
        User.sendInvitationEmail = async function (uid, email, groupsToJoin) {
            if (!uid) {
                throw new Error('[[error:invalid-uid]]');
            }
            const email_exists = await User.getUidByEmail(email);
            if (email_exists) {
                // Silently drop the invitation if the invited email already exists locally
                return;
            }
            const invitation_exists = await db.exists(`invitation:uid:${uid}:invited:${email}`);
            if (invitation_exists) {
                throw new Error('[[error:email-invited]]');
            }
            const data = Object.assign(Object.assign({}, emailer_1.default._defaultPayload), { site_title: title, registerLink: registerLink, subject: subject, username: username, template: 'invitation', expireDays: expireDays });
            await emailer_1.default.sendToEmail('invitation', email, metaConfig.defaultLang, data);
            await plugins_1.default.hooks.fire('action:user.invite', { uid, email, groupsToJoin });
        };
        User.verifyInvitation = async function (query) {
            if (!query.token) {
                if (metaConfig.registrationType.startsWith('admin-')) {
                    throw new Error('[[register:invite.error-admin-only]]');
                }
                else {
                    throw new Error('[[register:invite.error-invite-only]]');
                }
            }
            const token = await db.getObjectField(`invitation:token:${query.token}`, 'token');
            if (!token || token !== query.token) {
                throw new Error('[[register:invite.error-invalid-data]]');
            }
        };
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        async function deleteFromReferenceList(uid, email) {
            await Promise.all([
                await db.setRemove(`invitation:uid:${uid}`, email),
                await db.delete(`invitation:uid:${uid}:invited:${email}`),
            ]);
            const count = await db.setCount(`invitation:uid:${uid}`);
            if (count === 0) {
                await db.setRemove('invitation:uids', uid);
            }
        }
        User.confirmIfInviteEmailIsUsed = async function (token, enteredEmail, uid) {
            if (!enteredEmail) {
                return;
            }
            const email = await db.getObjectField(`invitation:token:${token}`, 'email');
            // "Confirm" user's email if registration completed with invited address
            if (email && email === enteredEmail) {
                await User.confirmByUid(uid);
            }
        };
        User.joinGroupsFromInvitation = async function (uid, token) {
            const groupsToJoinJSON = await db.getObjectField(`invitation:token:${token}`, 'groupsToJoin');
            try {
                groupsToJoin = JSON.parse(groupsToJoinJSON);
            }
            catch (e) {
                return;
            }
            if (!groupsToJoin || groupsToJoin.length < 1) {
                return;
            }
            await groups.join(groupsToJoin, uid);
        };
        User.deleteInvitation = async function (invitedBy, email) {
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
        User.deleteInvitationKey = async function (registrationEmail, token) {
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
    }
};
