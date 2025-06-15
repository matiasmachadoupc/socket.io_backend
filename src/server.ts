import express from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import userRoutes from './modules/users/user_routes.js';
import forumRoutes from './modules/forum/forum_routes.js';
import subjectRoutes from './modules/subject/subject_routes.js';
import { corsHandler } from './middleware/corsHandler.js';
import { loggingHandler } from './middleware/loggingHandler.js';
import { routeNotFound } from './middleware/routeNotFound.js';
import swaggerUi from 'swagger-ui-express';
import swaggerJSDoc from 'swagger-jsdoc';
import http from 'http';
import { Server } from 'socket.io';
import { verifyAccessToken } from './modules/auth/jwt.js';

dotenv.config(); // Cargamos las variables de entorno desde el archivo .env

const app = express();

const LOCAL_PORT = process.env.SERVER_PORT || 9000;

// Configuración de Swagger
const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'API de Usuarios',
            version: '1.0.0',
            description: 'Documentación de la API de Usuarios'
        },
        tags: [
            {
                name: 'Users',
                description: 'Rutas relacionadas con la gestión de usuarios'
            },
            {
                name: 'Forum',
                description: 'Rutas relacionadas con el forum'
            },
            {
                name: 'Main',
                description: 'Rutas principales de la API'
            }
        ],
        servers: [
            {
                url: `http://localhost:${LOCAL_PORT}`
            }
        ]
    },
    apis: ['./modules/users/*.js', './modules/forum/*.js', './modules/subject/*.js'] // Asegúrate de que esta ruta apunta a tus rutas
};

const swaggerSpec = swaggerJSDoc(swaggerOptions);

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Middleware
app.use(express.json());
app.use(loggingHandler);
app.use(corsHandler);

const httpServer = http.createServer(app);

// -------------------- SERVIDOR DE CHAT SOCKET.IO --------------------
// Interfaz para tipado de mensajes del chat
interface ChatMessage {
    messageId: string; // <-- nuevo
    room: string;
    author: string;
    message: string;
    time: string;
    // readBy?: string[]; // opcional, si quieres mantenerlo en servidor
}

// Puerto específico para el servidor de chat
const CHAT_PORT = process.env.CHAT_PORT || 3001;

// Crear servidor HTTP para el chat
const chatServer = http.createServer();

// Configurar Socket.IO para el chat con CORS
const chatIO = new Server(chatServer, {
    cors: {
        origin: '*', // Permitir cualquier origen (ajustar en producción)
        methods: ['GET', 'POST'],
        credentials: true
    }
});

// Manejar conexiones de Socket.IO para el chat
chatIO.on('connection', (socket) => {
    console.log(`Usuario conectado al chat: ${socket.id}`);

    // Verificación JWT para el socket principal
    socket.use(([event, ...args], next) => {
        const token = socket.handshake.auth.token;
        if (!token) return next(new Error('unauthorized'));

        try {
            verifyAccessToken(token);
            return next();
        } catch (err) {
            return next(new Error('unauthorized'));
        }
    });

    socket.on('error', (err) => {
        if (err && err.message == 'unauthorized') {
            console.debug('unauthorized user');
            socket.emit('status', { status: 'unauthorized' });
            socket.disconnect();
        }
    });

    // Manejar evento para unirse a una sala
    socket.on('join_room', async (data: { room: string; author: string }) => {
        socket.join(data.room);
        socket.data.room = data.room;
        socket.data.author = data.author;
        // Obtener todos los sockets de la sala
        const clients = await chatIO.in(data.room).fetchSockets();
        // Construir objeto users: { [author]: socketId }
        const users: Record<string, string> = {};
        clients.forEach(s => {
            if (s.data.author) {
                users[s.data.author] = s.id;
            }
        });
        chatIO.in(data.room).emit('online_users', Object.entries(users).map(([username, socketId]) => ({ username, socketId })));
        chatIO.in(data.room).emit('user_joined', {
            author: data.author,
            socketId: socket.id,
            users
        });
        console.log(`Usuario con ID: ${socket.id} se unió a la sala: ${data.room}`);
    });

    // Manejar evento para enviar un mensaje
    socket.on('send_message', (data: ChatMessage) => {
        socket.to(data.room).emit('receive_message', data);
        console.log(`Mensaje enviado en sala ${data.room} por ${data.author}: ${data.message}`);
    });

    // Usuario empieza a escribir
    socket.on('typing', (data: { room: string; author: string }) => {
        socket.to(data.room).emit('user_typing', data.author);
    });

    // Usuario deja de escribir
    socket.on('stop_typing', (data: { room: string; author: string }) => {
        socket.to(data.room).emit('user_stop_typing', data.author);
    });

    // Confirmación de lectura
    socket.on('message_read', (data: { room: string; messageId: string; reader: string }) => {
        socket.to(data.room).emit('update_read_receipts', {
            messageId: data.messageId,
            reader: data.reader
        });
    });

    // Mensajes privados (“whispers”)
    // El cliente debe enviar: { toSocketId, message: ChatMessage }
    socket.on('private_message', (data: { toSocketId: string; message: ChatMessage }) => {
        socket.to(data.toSocketId).emit('receive_private_message', data.message);
    });

    // Reacciones en mensajes
    // Cliente emite: { room, messageId, emoji, reactor }
    socket.on('react_message', (data: { room: string; messageId: string; emoji: string; reactor: string }) => {
        socket.to(data.room).emit('update_reactions', {
            messageId: data.messageId,
            emoji: data.emoji,
            reactor: data.reactor
        });
    });

    // Notificación de desconexión
    socket.on('disconnect', async () => {
        const { room, author } = socket.data as { room?: string; author?: string };
        if (room) {
            // Recalcula la lista de usuarios conectados
            const clients = await chatIO.in(room).fetchSockets();
            // Construir objeto users: { [author]: socketId }
            const users: Record<string, string> = {};
            clients.forEach(s => {
                if (s.data.author) {
                    users[s.data.author] = s.id;
                }
            });
            chatIO.in(room).emit('online_users', Object.entries(users).map(([username, socketId]) => ({ username, socketId })));
            chatIO.in(room).emit('user_left', {
                author,
                users
            });
        }
        console.log(`Usuario desconectado del chat: ${socket.id}`);
    });
});

// Iniciar el servidor de chat
chatServer.listen(CHAT_PORT, () => {
    console.log(`Servidor de chat escuchando en http://localhost:${CHAT_PORT}`);
});

// -------------------- RUTAS API Y SERVIDOR EXPRESS --------------------
app.use('/api', userRoutes);
app.use('/api', forumRoutes);
app.use('/api', subjectRoutes);

// Rutas de prueba
app.get('/', (req, res) => {
    res.send('Welcome to my API');
});

// Conexión a MongoDB
mongoose
    .connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/seminarioExpress')
    .then(() => console.log('Connected to DB'))
    .catch((error) => console.error('DB Connection Error:', error));

// Iniciar el servidor Express
app.listen(LOCAL_PORT, () => {
    console.log('Server listening on port: ' + LOCAL_PORT);
    console.log(`Swagger disponible en http://localhost:${LOCAL_PORT}/api-docs`);
});
