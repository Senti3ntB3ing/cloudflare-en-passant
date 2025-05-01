import { TwitchChat } from "../public/twitch_chat";

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

export default {
	async fetch(request, env, ctx) {
		
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
			default:
				return new Response('Not Found', { status: 404 });
		}
	},
};