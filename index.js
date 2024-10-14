import WebSocket from "ws";
import dotenv from "dotenv";
import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

dotenv.config();

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please, set it in the .env file.');
    process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const SYSTEM_MESSAGE = 'You are a lead intake bot for E. Orum Young Law, LLC (a bankruptcy law firm located at 200 Washington Street, Monroe, La.). You handle incoming phone calls from clients and non-clients, alike. Your goal is to complete the following steps, irrespective of order: 1.Collect the first and last name of the user (and case number if they are a client). 2.Find out their needs, and respond accordingly. 3.Schedule an appointment for a consultation, if requested by caller. 4.Answer any question the user has as long as it pertains to the bankruptcy law firm for whom you work (If their question is unrelated to business, remind them to stay within the scope of the firm during the call).';
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050;

fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Say>Thank you for calling E. Orum Young Law, LLC. Please wait while we connect you to our voice assistant, powered by Twilio, OpenAI, and the wizards on the coding team.</Say>
        <Pause length="1"/>
        <Say>Alright, you may begin! How may we be of service to you today?</Say>
        <Connect>
            <Stream url="wss://${request.headers.host}/media-stream" />
        </Connect>
    </Response>`;
    reply.type('text/xml').send(twimlResponse);
});

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client has successfully connected.');

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`, // Backticks for string interpolation
                "openAI-Beta": "realtime=v1",
            },
        });

        let streamSid = null;

        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: "session.update",
                session: {
                    turn_detection: { type: "server_vad" },
                    input_audio_format: "g711_ulaw",
                    output_audio_format: "g711_ulaw",
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };

            if (openAiWs.readyState === WebSocket.OPEN) {
                console.log("Sending session update:", JSON.stringify(sessionUpdate));
                openAiWs.send(JSON.stringify(sessionUpdate));
            }
        };

        openAiWs.on("open", () => {
            console.log("Connected to the OpenAI Realtime API");
            setTimeout(sendSessionUpdate, 1000);
        });

        openAiWs.on("message", (data) => {
            try {
                const response = JSON.parse(data);
                if (response.type === "session.updated") {
                    console.log("Session updated successfully:", response);
                } else if (response.type === "response.audio.delta" && response.delta) {
                    const audioDelta = {
                        event: "media",
                        streamSid: streamSid,
                        media: {
                            payload: Buffer.from(response.delta, "base64").toString("base64"),
                        }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }
            } catch (error) {
                console.error("Error processing OpenAI message:", error, "Raw message:", data);
            }
        });

        connection.on("message", (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case "start":
                        streamSid = data.start.streamSid;
                        console.log("Incoming stream has started", streamSid);
                        break;
                    case "media":
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: "input_audio_buffer.append",
                                audio: data.media.payload,
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    default:
                        console.log("Received non-media event: ", data.event);
                }
            } catch (error) {
                console.error("Error parsing message: ", error, "Message: ", message);
            }
        });
    });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server listening on port ${PORT}`);
});
