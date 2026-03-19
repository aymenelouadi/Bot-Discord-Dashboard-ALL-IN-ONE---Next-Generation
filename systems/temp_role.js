/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */

const fs = require('fs');
const path = require('path');

module.exports = {
    name: 'temp-role-system',
    
    execute(client) {
        this.client = client;
        this.dbPath = path.join(__dirname, '../database/temp_role.json');
        this.checkExpiredRoles();
        
        setInterval(() => {
            this.checkExpiredRoles();
        }, 30000);
        
        console.log('Temporary Role System has been loaded');
    },
    
    loadDatabase() {
        try {
            if (!fs.existsSync(this.dbPath)) {
                fs.writeFileSync(this.dbPath, JSON.stringify({}, null, 2));
                return {};
            } else {
                const data = fs.readFileSync(this.dbPath, 'utf8').replace(/^\uFEFF/, '');
                return JSON.parse(data);
            }
        } catch (error) {
            console.error('Error loading temporary roles database:', error);
            return {};
        }
    },
    
    saveDatabase(db) {
        try {
            fs.writeFileSync(this.dbPath, JSON.stringify(db, null, 2));
            return true;
        } catch (error) {
            console.error('Error saving temporary roles database:', error);
            return false;
        }
    },
    
    async checkExpiredRoles() {
        try {
            const db = this.loadDatabase();
            const now = Date.now();
            let changed = false;
            
            for (const [key, data] of Object.entries(db)) {
                if (data.expireAt <= now) {
                    try {
                        const guild = await this.client.guilds.fetch(data.guildId).catch(() => null);
                        if (!guild) continue;
                        
                        const member = await guild.members.fetch(data.userId).catch(() => null);
                        if (!member) continue;
                        
                        const role = guild.roles.cache.get(data.roleId);
                        if (!role) continue;
                        
                        if (member.roles.cache.has(data.roleId)) {
                            await member.roles.remove(role);
                            
                            try {
                                await member.send(`⚠️ انتهت مدة الرتبة المؤقتة\nتم إزالة رتبة **${data.roleName}** من سيرفر **${guild.name}**`);
                            } catch (dmError) {}
                            
                            console.log(`Temporary role ${data.roleName} removed from ${member.user.tag}`);
                        }
                        
                        delete db[key];
                        changed = true;
                        
                    } catch (error) {
                        console.error(`Error removing temporary role ${key}:`, error.message);
                    }
                }
            }
            
            if (changed) {
                this.saveDatabase(db);
            }
            
        } catch (error) {
            console.error('Error in checkExpiredRoles:', error);
        }
    }
};

/*
 * This project was programmed by the Next Generation team.
 * If you encounter any problems, open an Issue or log into the Discord server:
 * https://discord.gg/BhJStSa89s
 */