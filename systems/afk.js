/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const fs = require('fs');
const path = require('path');

module.exports = {
    name: 'afk',

    execute(client) {
        console.log('[system] AFK system loaded');

        setInterval(() => {
            this.cleanOldAFK();
        }, 60 * 60 * 1000); // كل ساعة
    },

    cleanOldAFK() {
        const dbPath = path.join(__dirname, '../database/afk.json');

        if (!fs.existsSync(dbPath)) {
            return;
        }

        try {
            const fileContent = fs.readFileSync(dbPath, 'utf8').replace(/^\uFEFF/, '');
            const database = JSON.parse(fileContent);

            const now = Date.now();
            const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000); // أسبوع

            let cleaned = 0;
            const newDatabase = {};

            for (const [userId, afkData] of Object.entries(database)) {
                if (afkData.timestamp > oneWeekAgo) {
                    newDatabase[userId] = afkData;
                } else {
                    cleaned++;
                }
            }

            if (cleaned > 0) {
                fs.writeFileSync(dbPath, JSON.stringify(newDatabase, null, 2));
                console.log(`[AFK System] Cleaned ${cleaned} old AFK records`);
            }
        } catch (error) {
            console.error('Error cleaning old AFK:', error);
        }

    }
};

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */