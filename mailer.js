const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

async function sendResetEmail(email, token, resetUrl) {
    const mailOptions = {
        from: `"Victory Messenger" <${process.env.SMTP_USER}>`,
        to: email,
        subject: 'Восстановление пароля',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f9f9f9; border-radius: 12px;">
                <h2 style="color: #FF6B9D;">Victory</h2>
                <p>Вы запросили восстановление пароля для вашего аккаунта.</p>
                <p>Для сброса пароля нажмите на кнопку ниже:</p>
                <a href="${resetUrl}" style="display: inline-block; padding: 12px 24px; background: #FF6B9D; color: white; text-decoration: none; border-radius: 50px; font-weight: 600;">Сбросить пароль</a>
                <p style="margin-top: 20px; font-size: 12px; color: #999;">Ссылка действительна в течение 1 часа. Если вы не запрашивали сброс пароля, просто проигнорируйте это письмо.</p>
            </div>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Письмо отправлено на ${email}`);
        return true;
    } catch (error) {
        console.error('Ошибка отправки письма:', error);
        return false;
    }
}

module.exports = { sendResetEmail };