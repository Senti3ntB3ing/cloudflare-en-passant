

/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
//let chat = new TwitchChat;
import { Database } from "../public/database";

export default {
	async fetch(request, env, ctx) {
		const TWITCH_APP_ID = await Database.get("twitch_app_id");
		const TWITCH_APP_SECRET = await Database.get("twitch_app_secret");
		const TWITCH_REFRESH = await Database.get("twitch_refresh_token");
		const TWITCH_OAUTH_BOT = await Database.get("twitch_oauth_bot");

		const TWITCH_MESSAGE_ID = 'Twitch-Eventsub-Message-Id'.toLowerCase();
		const TWITCH_MESSAGE_TIMESTAMP = 'Twitch-Eventsub-Message-Timestamp'.toLowerCase();
		const TWITCH_MESSAGE_SIGNATURE = 'Twitch-Eventsub-Message-Signature'.toLowerCase();

		const MESSAGE_TYPE_VERIFICATION = 'webhook_callback_verification';
		const MESSAGE_TYPE_NOTIFICATION = 'notification';
		const MESSAGE_TYPE_REVOCATION = 'revocation';
		const HMAC_PREFIX = 'sha256=';

		const subURL = 'https://api.twitch.tv/helix/eventsub/subscriptions';
		const chatURL = 'https://api.twitch.tv/helix/chat/messages';

		const crypto = require('crypto');
		const subTypes = 'channel.chat.message;channel.chat.notification;channel.shared_chat.begin;channel.shared_chat.update;channel.shared_chat.end;'

		class TwitchChat {
			// Handle Callbacks
			// == notification ; webook_callback_varification ; revocation ;
			// Verify event message
			#secret;

			constructor() {
				this.#getSecret()
				if (this.getSubscriptions() < 1) {
					this.subscribe(subTypes)
				}

			}

			notification(request) {
				let message = this.#getHmacMessage(request);
				let hmac = HMAC_PREFIX + this.#getHmac(this.#secret, message);
				if (this.#verifyMessage(hmac, req.headers[TWITCH_MESSAGE_SIGNATURE])) {
					let data = JSON.parse(request.body);
					let messageType = request.headers[TWITCH_MESSAGE_SIGNATURE];

					switch (messageType) {
						case MESSAGE_TYPE_NOTIFICATION:
							return 204
						//res.sendStatus(204)
						case MESSAGE_TYPE_VERIFICATION:
							return data.challenge
						//res.set('Content-Type', 'text/plain').status(200).send(notification.challenge);
						case MESSAGE_TYPE_REVOCATION:
							return 204
						default:
							return 403
						//res.sendStatus(403) //doesn't match
					}

				}
			}

			async getSubscriptions() {
				let url = 'https://api.twitch.tv/helix/eventsub/subscriptions';
				let payload = {
					method: "GET",
					headers: {
						"Authorization": "Bearer " + TWITCH_OAUTH_BOT,
						"Client-Id": TWITCH_APP_ID
					}
				}
				let response = await fetch(url, payload);
				return response.total ? response.total : 0
			}

			async subscribe(subscriptions) {
				let items = subscriptions.split(";");
				let responses = {};
				for (const item of items) {
					let payload = {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"Authorization": "Bearer " + TWITCH_OAUTH_BOT, // and this
							"Client-Id": TWITCH_APP_ID // need to pull this from database
						},
						body: JSON.stringify({
							type: item,
							version: "1",
							"condition": {
								"broadcaster_user_id": 428214501, //hardcoded because fuck you
							},
							transport: {
								method: "webhook",
								callback: "https://cloudflare-en-passant.chanceloricco-chessnerd.workers.dev/callback",
								secret: this.#secret
							}
						})
					};

					let response = await fetch(subURL, payload);
					if (response.status == 202) {
						let resJson = await response.json();
						let { data } = await resJson;
						let [subData] = await data;
						subData.status = 202;
						responses.item = subData;
					}
					responses.item = response;
				}
				return responses
			}

			async chat(message) {
				let payload = {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Authorization": "Bearer " + TWITCH_OAUTH_BOT, // and this
						"Client-Id": TWITCH_APP_ID // need to pull this from database
					},
					body: JSON.stringify({
						"broadcaster_user_id": 428214501,
						"sender_id": 'sadf',//figure this out buddy
						"message": message,
						"for_source_only": true
					})
				};
			}

			#getSecret() {
				//generate secret or pull from somewhere - could use rand
				this.#secret = 'SECRET123';
			}

			#getHmacMessage(request) {
				return (request.headers[TWITCH_MESSAGE_ID] +
					request.headers[TWITCH_MESSAGE_TIMESTAMP] +
					request.body);
			}

			#getHmac(secret, message) {
				return crypto.createHmac('sha256', secret)
					.update(message)
					.digest('hex');
			}

			#verifyMessage(hmac, verifySignature) {
				return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(verifySignature));
			}
		}


		const url = new URL(request.url);
		switch (url.pathname) {
			case '/refresh':
				return new Response('Refresh!');
			case '/mod':
				return new Response('Mod!');
			case '/queue':
				return new Response('Queue!');
			case '/validate':
				return new Response('Validate!');
			case '/connect':
				return new Response('Connect!');
			case '/ext':
				return new Response('Extension!');
			case '/random':
				return new Response(crypto.randomUUID());
			case '/message':
				return new Response('Test!');
			case '/callback':
				//let test = chat.notification(request);
				//console.log(test);
				return new Response('callback');
			case '/init':
				return new Response('init!');
			default:
				return new Response('Not Found', { status: 404 });
		}
	},
};