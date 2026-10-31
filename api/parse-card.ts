export default async function handler(req: any, res: any) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  
    try {
      const data = req.body;
  
      if (!data) {
        return res.status(400).json({ error: 'Chybí data karty' });
      }
  
      return res.status(200).json({ success: true, data });
    } catch (error: any) {
      return res.status(500).json({ error: error.message || 'Chyba při parsování karty' });
    }
  }