/* eslint-disable import/no-extraneous-dependencies */
import bcrypt from 'bcrypt';
import fs from 'fs';
import { pathToFileURL } from 'url';
import { KeyvFile } from 'keyv-file';
import ChatGPTClient from '../ChatGPTClient.js';
import ChatGPTBrowserClient from '../ChatGPTBrowserClient.js';
import BingAIClient from '../BingAIClient.js';
import {
    createUser, getUserByToken, getUserByEmail, generateToken, removeToken,
} from './db-utils.js';

const arg = process.argv.find(_arg => _arg.startsWith('--settings'));
const path = arg?.split('=')[1] ?? './settings.js';

let settings;
if (fs.existsSync(path)) {
    // get the full path
    const fullPath = fs.realpathSync(path);
    settings = (await import(pathToFileURL(fullPath).toString())).default;
} else {
    if (arg) {
        console.error('Error: the file specified by the --settings parameter does not exist.');
    } else {
        console.error('Error: the settings.js file does not exist.');
    }
    process.exit(1);
}

if (settings.storageFilePath && !settings.cacheOptions.store) {
    // make the directory and file if they don't exist
    const dir = settings.storageFilePath.split('/').slice(0, -1).join('/');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(settings.storageFilePath)) {
        fs.writeFileSync(settings.storageFilePath, '');
    }

    settings.cacheOptions.store = new KeyvFile({ filename: settings.storageFilePath });
}

const clientToUse = settings.apiOptions?.clientToUse || settings.clientToUse || 'chatgpt';
const perMessageClientOptionsWhitelist = settings.apiOptions?.perMessageClientOptionsWhitelist || null;

// eslint-disable-next-line no-unused-vars
const usersRoutes = async (fastify, opts) => {
    fastify
        .decorate('asyncVerifyJWT', async (request, reply) => {
            try {
                if (!request.headers.authorization) {
                    throw new Error('No token was sent');
                }
                const token = request.headers.authorization.replace('Bearer ', '');
                const user = await getUserByToken(token);
                if (!user) {
                    // handles logged out user with valid token
                    throw new Error('Authentication failed!');
                }
                request.user = user;
                request.token = token; // used in logout route
            } catch (error) {
                reply.code(401).send(error);
            }
        })
        .decorate('asyncVerifyUsernameAndPassword', async (request, reply) => {
            try {
                if (!request.body) {
                    throw new Error('username and Password is required!');
                }
                console.log('1');
                const user = await getUserByEmail(request.body.email);
                console.log(user.password_hash);
                if (!bcrypt.compare(request.body.password, user.password_hash)) {
                    reply.code(401).send({ message: 'Wrong Password' });
                }
                request.user = user;
            } catch (error) {
                reply.code(400).send(error);
            }
        })
        .after(() => {
            fastify.route({
                method: ['POST', 'HEAD'],
                url: '/register',
                logLevel: 'warn',
                handler: async (req, reply) => {
                    const { body } = req;
                    try {
                        const salt = bcrypt.genSaltSync(10);
                        console.log(body.password, salt);
                        const hashedPassword = bcrypt.hashSync(body.password, salt);
                        const userId = await createUser(body.user_name, body.email, hashedPassword);
                        reply.status(201).send({ userId });
                    } catch (error) {
                        console.log(error);
                        reply.status(500).send({ message: 'Error creating user', error });
                    }
                },
            });

            // login route
            fastify.route({
                method: ['POST', 'HEAD'],
                url: '/login',
                logLevel: 'warn',
                preHandler: fastify.auth([fastify.asyncVerifyUsernameAndPassword]),
                handler: async (req, reply) => {
                    const user = await generateToken(req.user);
                    req.user.token = user.token;
                    delete req.user.password_hash;
                    delete req.user.id;
                    delete req.user.email;
                    reply.send({ status: 'You are logged in', user: req.user });
                },
            });

            // logout route
            fastify.route({
                method: ['POST', 'HEAD'],
                url: '/logout',
                logLevel: 'warn',
                preHandler: fastify.auth([fastify.asyncVerifyJWT]),
                handler: async (req, reply) => {
                    try {
                        const loggedOutUser = removeToken(req.user);
                        reply.send({ status: 'You are logged out!', user: loggedOutUser });
                    } catch (e) {
                        reply.status(500).send();
                    }
                },
            });
        });

    fastify.route({
        method: ['POST'],
        url: '/conversation',
        logLevel: 'warn',
        preHandler: fastify.auth([fastify.asyncVerifyJWT]),
        handler: async (request, reply) => {
            const body = request.body || {};
            const abortController = new AbortController();

            console.log(body.message);
            reply.raw.on('close', () => {
                if (abortController.signal.aborted === false) {
                    abortController.abort();
                }
            });

            let onProgress;
            if (body.stream === true) {
                onProgress = (token) => {
                    if (settings.apiOptions?.debug) {
                        console.debug(token);
                    }
                    if (token !== '[DONE]') {
                        reply.sse({ id: '', data: JSON.stringify(token) });
                    }
                };
            } else {
                onProgress = null;
            }

            let result;
            let error;
            try {
                if (!body.message) {
                    const invalidError = new Error();
                    invalidError.data = {
                        code: 400,
                        message: 'The message parameter is required.',
                    };
                    // noinspection ExceptionCaughtLocallyJS
                    throw invalidError;
                }

                let clientToUseForMessage = clientToUse;
                const clientOptions = filterClientOptions(body.clientOptions, clientToUseForMessage);
                if (clientOptions && clientOptions.clientToUse) {
                    clientToUseForMessage = clientOptions.clientToUse;
                    delete clientOptions.clientToUse;
                }

                const messageClient = getClient(clientToUseForMessage);

                result = await messageClient.sendMessage(body.message, {
                    jailbreakConversationId: body.jailbreakConversationId,
                    conversationId: body.conversationId ? body.conversationId.toString() : undefined,
                    parentMessageId: body.parentMessageId ? body.parentMessageId.toString() : undefined,
                    conversationSignature: body.conversationSignature,
                    clientId: body.clientId,
                    invocationId: body.invocationId,
                    shouldGenerateTitle: settings.apiOptions?.generateTitles || false, // only used for ChatGPTClient
                    clientOptions,
                    onProgress,
                    abortController,
                });
            } catch (e) {
                error = e;
            }

            if (result !== undefined) {
                if (settings.apiOptions?.debug) {
                    console.debug(result);
                }
                if (body.stream === true) {
                    reply.sse({ event: 'result', id: '', data: JSON.stringify(result) });
                    reply.sse({ id: '', data: '[DONE]' });
                    await nextTick();
                    return reply.raw.end();
                }
                return reply.send(result);
            }

            const code = error?.data?.code || 503;
            if (code === 503) {
                console.error(error);
            } else if (settings.apiOptions?.debug) {
                console.debug(error);
            }
            const message = error?.data?.message || `There was an error communicating with ${clientToUse === 'bing' ? 'Bing' : 'ChatGPT'}.`;
            if (body.stream === true) {
                reply.sse({
                    id: '',
                    event: 'error',
                    data: JSON.stringify({
                        code,
                        error: message,
                    }),
                });
                await nextTick();
                return reply.raw.end();
            }
            return reply.code(code).send({ error: message });
        },
    });
};

/**
 * Filter objects to only include whitelisted properties set in
 * `settings.js` > `apiOptions.perMessageClientOptionsWhitelist`.
 * Returns original object if no whitelist is set.
 * @param {*} inputOptions
 * @param clientToUseForMessage
 */
function filterClientOptions(inputOptions, clientToUseForMessage) {
    if (!inputOptions || !perMessageClientOptionsWhitelist) {
        return null;
    }

    // If inputOptions.clientToUse is set and is in the whitelist, use it instead of the default
    if (
        perMessageClientOptionsWhitelist.validClientsToUse
        && inputOptions.clientToUse
        && perMessageClientOptionsWhitelist.validClientsToUse.includes(inputOptions.clientToUse)
    ) {
        clientToUseForMessage = inputOptions.clientToUse;
    } else {
        inputOptions.clientToUse = clientToUseForMessage;
    }

    const whitelist = perMessageClientOptionsWhitelist[clientToUseForMessage];
    if (!whitelist) {
        // No whitelist, return all options
        return inputOptions;
    }

    const outputOptions = {
        clientToUse: clientToUseForMessage,
    };

    for (const property of Object.keys(inputOptions)) {
        const allowed = whitelist.includes(property);

        if (!allowed && typeof inputOptions[property] === 'object') {
            // Check for nested properties
            for (const nestedProp of Object.keys(inputOptions[property])) {
                const nestedAllowed = whitelist.includes(`${property}.${nestedProp}`);
                if (nestedAllowed) {
                    outputOptions[property] = outputOptions[property] || {};
                    outputOptions[property][nestedProp] = inputOptions[property][nestedProp];
                }
            }
            continue;
        }

        // Copy allowed properties to outputOptions
        if (allowed) {
            outputOptions[property] = inputOptions[property];
        }
    }

    return outputOptions;
}

function nextTick() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function getClient(clientToUseForMessage) {
    switch (clientToUseForMessage) {
        case 'bing':
            return new BingAIClient({ ...settings.bingAiClient, cache: settings.cacheOptions });
        case 'chatgpt-browser':
            return new ChatGPTBrowserClient(
                settings.chatGptBrowserClient,
                settings.cacheOptions,
            );
        case 'chatgpt':
            return new ChatGPTClient(
                settings.openaiApiKey || settings.chatGptClient.openaiApiKey,
                settings.chatGptClient,
                settings.cacheOptions,
            );
        default:
            throw new Error(`Invalid clientToUse: ${clientToUseForMessage}`);
    }
}

export default usersRoutes;
