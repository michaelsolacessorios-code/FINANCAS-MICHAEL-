import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
  const { senha } = req.body || {};
  if (!senha) return res.status(400).json({ error: 'Informe a senha.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return res.status(200).json({ hash: salt + ':' + hash });
}
