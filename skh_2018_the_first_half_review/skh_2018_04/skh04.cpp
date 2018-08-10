// 16진수 대소비교
#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include<stdlib.h>

int hextodec(char* phex, int pos) {
	int v = 0;
	if (*phex == NULL) {
		return 0;
	}
	else if (*phex >= 'A' && *phex <= 'F') {
		v = ((int)(*phex - 'A') + 10);
	}
	else if (*phex >= '0' && *phex <= '9') {
		v = (int)(*phex - '0');
	}
	else {
		v = 0;
	}
	//printf("%d ", v << (4 * pos));
	return  (v << (4 * pos)) + hextodec(phex + 1, pos - 1);
}
int cntPos(char* phex) {
	//printf("%c ", *phex);
	if (*phex == NULL) {
		return 0;
	}
	else {
		return 1 + cntPos(phex + 1);
	}
}

int main() {
	char hex1[11], hex2[11];

	// get input
	printf("first hex : ");
	scanf("%s", hex1);
	printf("\nsecond hex : ");
	scanf("%s", hex2);
	
	// hex to dec
	int cnt1 = cntPos(hex1+2);
	int cnt2 = cntPos(hex2+2);
	int dec1 = hextodec(hex1+2,cnt1-1);
	int dec2 = hextodec(hex2+2, cnt2-1);
	
	int diff = dec1 - dec2;
	int ans = (diff & 1 << 31) == 0 ? 0 : 1;

	printf("dec : %d , %d \n", dec1, dec2);
	printf("diff : %d",ans);


	system("pause");
	return 0;
}